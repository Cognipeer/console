/**
 * The ceiling for buffering one stored object in memory (shared by the S3 and Azure Blob drivers).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { isStorageObjectTooLargeError, maxStorageDownloadBytes, StorageObjectTooLargeError } from '@/lib/providers/contracts/storageLimits';

const MIB = 1024 * 1024;
const original = getConfigSource();
afterEach(() => setConfigSource(original));

function withUploadLimit(megabytes: string | undefined) {
  setConfigSource({ get: (key: string) => (key === 'FILE_UPLOAD_MAX_MB' ? megabytes : process.env[key]) } as ConfigSource);
}

describe('maxStorageDownloadBytes', () => {
  it('is twice the upload limit, and at least 100 MiB', () => {
    withUploadLimit('80');
    expect(maxStorageDownloadBytes()).toBe(160 * MIB);
    withUploadLimit('50');
    expect(maxStorageDownloadBytes()).toBe(100 * MIB);
    withUploadLimit('10');
    expect(maxStorageDownloadBytes()).toBe(100 * MIB);
    withUploadLimit('500');
    expect(maxStorageDownloadBytes()).toBe(1000 * MIB);
  });

  it('follows the default upload limit (50 MiB) when none is configured', () => {
    withUploadLimit(undefined);
    expect(maxStorageDownloadBytes()).toBe(100 * MIB);
  });

  it('never goes below the floor, whatever the configured limit is', () => {
    withUploadLimit('0');
    expect(maxStorageDownloadBytes()).toBe(100 * MIB);
    withUploadLimit('-5');
    expect(maxStorageDownloadBytes()).toBe(100 * MIB);
  });
});

describe('StorageObjectTooLargeError', () => {
  it('says in words for people how much the server reads at once, and is not worth retrying', () => {
    const error = new StorageObjectTooLargeError(100 * MIB);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'StorageObjectTooLargeError',
      code: 'object_too_large',
      retryable: false,
      message: 'The object is larger than the 100 MB this server reads into memory at once.',
    });
  });

  it('takes the current ceiling when none is given', () => {
    withUploadLimit('80');

    expect(new StorageObjectTooLargeError().message).toBe('The object is larger than the 160 MB this server reads into memory at once.');
  });

  it('is recognised as itself, and by its name and code when it crossed a module boundary as a copy', () => {
    expect(isStorageObjectTooLargeError(new StorageObjectTooLargeError(MIB))).toBe(true);
    expect(isStorageObjectTooLargeError(Object.assign(new Error('x'), { name: 'StorageObjectTooLargeError', code: 'object_too_large' }))).toBe(true);
  });

  it.each([
    ['a plain error', new Error('The object is larger than the 100 MB this server reads into memory at once.')],
    ['an error with only the code', Object.assign(new Error('x'), { code: 'object_too_large' })],
    ['an error with only the name', Object.assign(new Error('x'), { name: 'StorageObjectTooLargeError' })],
    ['an error of another store with that code', Object.assign(new Error('x'), { name: 'S3OperationError', code: 'object_too_large' })],
    ['text', 'object_too_large'],
    ['null', null],
    ['nothing', undefined],
  ])('is not taken for %s', (_label, value) => {
    expect(isStorageObjectTooLargeError(value)).toBe(false);
  });
});
