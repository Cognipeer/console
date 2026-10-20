/**
 * The ceiling for buffering one stored object in memory (shared by the S3 and Azure Blob drivers).
 */
import { constants } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { resolveDownloadCeiling } from '@/lib/providers/contracts/downloadCeiling';
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

describe('resolveDownloadCeiling', () => {
  it('is the server-wide ceiling when the caller states no bound', () => {
    withUploadLimit('80');
    expect(resolveDownloadCeiling()).toBe(160 * MIB);
    expect(resolveDownloadCeiling({})).toBe(160 * MIB);
    expect(resolveDownloadCeiling({ maxBytes: undefined })).toBe(160 * MIB);
  });

  it('is the bound the caller states, above the server-wide ceiling or below it', () => {
    withUploadLimit('50');
    expect(resolveDownloadCeiling({ maxBytes: 300 * MIB })).toBe(300 * MIB);
    expect(resolveDownloadCeiling({ maxBytes: 5 * MIB })).toBe(5 * MIB);
    expect(resolveDownloadCeiling({ maxBytes: 1 })).toBe(1);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['text', '5242880'],
    ['null', null],
  ])('ignores a bound that is %s: it is no bound', (_label, maxBytes) => {
    withUploadLimit('50');
    expect(resolveDownloadCeiling({ maxBytes } as never)).toBe(100 * MIB);
  });

  it('never goes beyond what one Buffer can hold: no bound at all means that much', () => {
    withUploadLimit('50');
    expect(resolveDownloadCeiling({ maxBytes: Number.POSITIVE_INFINITY })).toBe(constants.MAX_LENGTH);
    expect(resolveDownloadCeiling({ maxBytes: Number.MAX_SAFE_INTEGER * 2 })).toBeLessThanOrEqual(constants.MAX_LENGTH);
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
