/**
 * Unit tests - which files the Document Store may show inline, and as what.
 *
 * A preview is served from the console's own origin, so only types a browser renders without running anything
 * are allowed, text is always sent as plain text, and a large object is refused rather than read into memory.
 */

import { describe, expect, it } from 'vitest';
import { assertPreviewSize, planPreview, PREVIEW_MAX_BYTES, PREVIEW_TEXT_CONTENT_TYPE } from '@/lib/services/files/preview';
import { isFileServiceError } from '@/lib/services/files/errors';

/** What the preview refusal looks like to a route. */
function refusalOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(isFileServiceError(error)).toBe(true);
    const refusal = error as import('@/lib/services/files/errors').FileServiceError;
    return { code: refusal.code, status: refusal.status, reason: refusal.details?.reason, message: refusal.message };
  }
  throw new Error('expected a refusal');
}

describe('planPreview', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'])('serves %s as it is', (contentType) => {
    expect(planPreview({ contentType, size: 1024 })).toEqual({ contentType });
  });

  it.each(['text/plain', 'text/markdown', 'text/csv', 'application/json'])('serves %s as plain text', (contentType) => {
    expect(planPreview({ contentType, size: 10 })).toEqual({ contentType: PREVIEW_TEXT_CONTENT_TYPE });
  });

  it('declares the text type with its charset', () => {
    expect(PREVIEW_TEXT_CONTENT_TYPE).toBe('text/plain; charset=utf-8');
  });

  it('reads the stored type the way the type filter does: parameters dropped, any case', () => {
    expect(planPreview({ contentType: 'Image/PNG; foo=bar', size: 1 })).toEqual({ contentType: 'image/png' });
    expect(planPreview({ contentType: 'TEXT/Markdown; charset=iso-8859-9', size: 1 })).toEqual({ contentType: PREVIEW_TEXT_CONTENT_TYPE });
  });

  it.each([
    'image/svg+xml',
    'text/html',
    'application/xhtml+xml',
    'text/xml',
    'application/xml',
    'text/javascript',
    'application/javascript',
    'application/octet-stream',
    'application/zip',
    'video/mp4',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/tiff',
    'text/x-shellscript',
    '',
  ])('refuses %s (415 preview_unsupported)', (contentType) => {
    expect(refusalOf(() => planPreview({ contentType, size: 1 }))).toMatchObject({
      code: 'preview_unsupported',
      status: 415,
      reason: 'unsupported_type',
    });
  });

  it('refuses a file with no stored type', () => {
    expect(refusalOf(() => planPreview({ size: 1 }))).toMatchObject({ code: 'preview_unsupported', reason: 'unsupported_type' });
    expect(refusalOf(() => planPreview({ contentType: null, size: 1 }))).toMatchObject({ code: 'preview_unsupported' });
  });

  it('refuses a type that merely starts like a safe one', () => {
    for (const contentType of ['image/png-evil', 'text/plainx', 'application/pdfx', 'application/json+evil']) {
      expect(refusalOf(() => planPreview({ contentType, size: 1 })), contentType).toMatchObject({ code: 'preview_unsupported' });
    }
  });

  it('allows an object of exactly the cap and refuses one byte more', () => {
    expect(PREVIEW_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(planPreview({ contentType: 'application/pdf', size: PREVIEW_MAX_BYTES })).toEqual({ contentType: 'application/pdf' });
    expect(refusalOf(() => planPreview({ contentType: 'application/pdf', size: PREVIEW_MAX_BYTES + 1 }))).toMatchObject({
      code: 'preview_unsupported',
      status: 415,
      reason: 'too_large',
    });
  });

  it('says in the message how large a preview may be', () => {
    expect(refusalOf(() => planPreview({ contentType: 'image/png', size: PREVIEW_MAX_BYTES + 1 })).message).toContain('10 MB');
  });

  it('does not decide on a size it was not given (the route checks the bytes it read)', () => {
    expect(planPreview({ contentType: 'image/png' })).toEqual({ contentType: 'image/png' });
    expect(planPreview({ contentType: 'image/png', size: null })).toEqual({ contentType: 'image/png' });
  });

  describe('the Markdown copy', () => {
    it('is plain text whatever the original is', () => {
      expect(planPreview({ variant: 'markdown', contentType: 'application/pdf', size: 100 })).toEqual({ contentType: PREVIEW_TEXT_CONTENT_TYPE });
      expect(planPreview({ variant: 'markdown', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 100 })).toEqual({ contentType: PREVIEW_TEXT_CONTENT_TYPE });
      expect(planPreview({ variant: 'markdown', size: 100 })).toEqual({ contentType: PREVIEW_TEXT_CONTENT_TYPE });
    });

    it('is capped like any preview', () => {
      expect(refusalOf(() => planPreview({ variant: 'markdown', contentType: 'application/pdf', size: PREVIEW_MAX_BYTES + 1 }))).toMatchObject({ reason: 'too_large' });
    });
  });
});

describe('assertPreviewSize', () => {
  it('passes up to the cap and refuses past it', () => {
    expect(() => assertPreviewSize(0)).not.toThrow();
    expect(() => assertPreviewSize(PREVIEW_MAX_BYTES)).not.toThrow();
    expect(() => assertPreviewSize(undefined)).not.toThrow();
    expect(refusalOf(() => assertPreviewSize(PREVIEW_MAX_BYTES + 1))).toMatchObject({ code: 'preview_unsupported', status: 415, reason: 'too_large' });
  });
});
