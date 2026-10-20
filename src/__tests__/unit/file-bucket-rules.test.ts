/**
 * What a bucket's name, description, prefix and status may be (`bucketRules`): one set of rules for the creation
 * and the update of a bucket, and the two metadata keys the file service keeps for itself.
 */

import { describe, expect, it } from 'vitest';
import {
  BUCKET_DELETE_ERROR_KEY,
  BUCKET_DELETING_KEY,
  bucketDeleteError,
  isBucketDeleting,
  parseBucketDescription,
  parseBucketKey,
  parseBucketMetadata,
  parseBucketName,
  parseBucketPatch,
  parseBucketPrefix,
  parseBucketStatus,
  reservedBucketMetadata,
  withoutReservedBucketMetadata,
} from '@/lib/services/files/bucketRules';
import { isFileServiceError } from '@/lib/services/files/errors';

function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(isFileServiceError(error)).toBe(true);
    return error as { code: string; status: number; message: string };
  }
  throw new Error('expected a refusal');
}

describe('parseBucketKey', () => {
  it('keeps a key of 1 to 64 lowercase letters, digits, hyphens and underscores, trimmed', () => {
    expect(parseBucketKey('  contracts-2025_q3 ')).toBe('contracts-2025_q3');
    expect(parseBucketKey('x')).toBe('x');
    expect(parseBucketKey('k'.repeat(64))).toHaveLength(64);
  });

  it('refuses a key no route could address, or that is too long, or not text', () => {
    for (const value of [
      '', '   ', 'k'.repeat(65), 5, null, undefined, ['a'], { a: 1 },
      'a/b', '../up', '..', '.', 'dot.ted', 'back\\slash', 'Upper', 'with space', 'q?x', 'h#x', 'p%2Fq', 'tab\tbed', 'nul\u0000', 'türkçe',
    ]) {
      expect(refusal(() => parseBucketKey(value)), String(value)).toMatchObject({ code: 'invalid_request', status: 400 });
    }
    expect(refusal(() => parseBucketKey('a/b')).message).toMatch(/\bkey\b/);
    expect(refusal(() => parseBucketKey('k'.repeat(65))).message).toMatch(/at most 64/);
  });
});

describe('parseBucketName', () => {
  it('keeps a name of 1 to 120 characters, trimmed', () => {
    expect(parseBucketName('  Contracts ')).toBe('Contracts');
    expect(parseBucketName('x')).toBe('x');
    expect(parseBucketName('n'.repeat(120))).toHaveLength(120);
  });

  it('refuses a name that is empty, too long, not text, or carries control characters', () => {
    for (const value of ['', '   ', 'n'.repeat(121), 5, null, undefined, ['a'], 'two\nlines', 'nul\u0000']) {
      expect(refusal(() => parseBucketName(value))).toMatchObject({ code: 'invalid_request', status: 400 });
    }
    expect(refusal(() => parseBucketName('')).message).toMatch(/name/);
  });
});

describe('parseBucketDescription', () => {
  it('keeps text, trimmed, and may run over several lines; null clears it', () => {
    expect(parseBucketDescription('  First line\nsecond line ')).toBe('First line\nsecond line');
    expect(parseBucketDescription('')).toBe('');
    expect(parseBucketDescription(null)).toBe('');
  });

  it('refuses what is not text, is too long or has control characters', () => {
    expect(refusal(() => parseBucketDescription(5)).message).toMatch(/description/);
    expect(refusal(() => parseBucketDescription('d'.repeat(1001))).status).toBe(400);
    expect(refusal(() => parseBucketDescription('bell\u0007')).code).toBe('invalid_request');
  });
});

describe('parseBucketStatus', () => {
  it('takes active and disabled and nothing else', () => {
    expect(parseBucketStatus('active')).toBe('active');
    expect(parseBucketStatus('disabled')).toBe('disabled');
    for (const value of ['Active', 'deleted', '', null, undefined, true]) {
      expect(refusal(() => parseBucketStatus(value))).toMatchObject({ code: 'invalid_request', status: 400 });
    }
  });
});

describe('parseBucketPrefix', () => {
  it('drops the slashes around a folder path and keeps the folders inside', () => {
    expect(parseBucketPrefix('docs')).toBe('docs');
    expect(parseBucketPrefix('/team/legal/')).toBe('team/legal');
    expect(parseBucketPrefix('  a/b/c  ')).toBe('a/b/c');
  });

  it('allows an empty prefix: the files sit in the root of the provider', () => {
    expect(parseBucketPrefix('')).toBe('');
    expect(parseBucketPrefix('  / ')).toBe('');
  });

  it('refuses a way out of the folder, an empty folder name, a backslash or a control character', () => {
    for (const value of ['..', '../x', 'a/../b', 'a/./b', '.', 'a//b', 'a\\b', 'tab\there', 'v1..2']) {
      expect(refusal(() => parseBucketPrefix(value))).toMatchObject({ code: 'invalid_request', status: 400 });
    }
  });

  it('refuses what is not text and a prefix that is too long', () => {
    expect(refusal(() => parseBucketPrefix(null)).message).toMatch(/prefix/);
    expect(refusal(() => parseBucketPrefix(['a'])).status).toBe(400);
    expect(parseBucketPrefix('p'.repeat(200))).toHaveLength(200);
    expect(refusal(() => parseBucketPrefix('p'.repeat(201))).status).toBe(400);
  });
});

describe('the metadata the file service keeps for itself', () => {
  it('is dropped from what a caller sends, and the rest is kept', () => {
    const sent = { team: 'legal', [BUCKET_DELETING_KEY]: false, [BUCKET_DELETE_ERROR_KEY]: 'made up' };
    expect(parseBucketMetadata(sent)).toEqual({ team: 'legal' });
    expect(withoutReservedBucketMetadata(sent)).toEqual({ team: 'legal' });
    expect(reservedBucketMetadata(sent)).toEqual({ [BUCKET_DELETING_KEY]: false, [BUCKET_DELETE_ERROR_KEY]: 'made up' });
    expect(reservedBucketMetadata(undefined)).toEqual({});
  });

  it('must be an object', () => {
    for (const value of ['x', 5, null, ['a'], true]) {
      expect(refusal(() => parseBucketMetadata(value)).message).toMatch(/metadata/);
    }
  });

  it('says whether a bucket is being deleted and why its last deletion stopped', () => {
    expect(isBucketDeleting({ metadata: { deleting: true } })).toBe(true);
    expect(isBucketDeleting({ metadata: { deleting: 'yes' } })).toBe(false);
    expect(isBucketDeleting({ metadata: {} })).toBe(false);
    expect(isBucketDeleting({})).toBe(false);
    expect(bucketDeleteError({ metadata: { deleteError: '2 files could not be deleted.' } })).toBe('2 files could not be deleted.');
    expect(bucketDeleteError({ metadata: { deleteError: '' } })).toBeUndefined();
    expect(bucketDeleteError({ metadata: { deleteError: 7 } })).toBeUndefined();
    expect(bucketDeleteError({ metadata: null })).toBeUndefined();
  });
});

describe('parseBucketPatch', () => {
  it('returns only the fields the body names, each one checked', () => {
    expect(parseBucketPatch({})).toEqual({});
    expect(parseBucketPatch({ name: ' New name ', status: 'disabled', description: null, prefix: '/p/', metadata: { a: 1, deleting: true } }))
      .toEqual({ name: 'New name', status: 'disabled', description: '', prefix: 'p', metadata: { a: 1 } });
  });

  it('ignores a field that is absent, and refuses one that is there and wrong', () => {
    expect(parseBucketPatch({ name: undefined, key: 'cannot-change', providerKey: 'other' })).toEqual({});
    expect(refusal(() => parseBucketPatch({ name: '' })).message).toMatch(/name/);
    expect(refusal(() => parseBucketPatch({ status: 'paused' })).message).toMatch(/status/);
    expect(refusal(() => parseBucketPatch({ prefix: '../x' })).message).toMatch(/prefix/);
    expect(refusal(() => parseBucketPatch({ metadata: 'x' })).message).toMatch(/metadata/);
  });
});
